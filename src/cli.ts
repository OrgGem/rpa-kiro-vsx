import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import type {
    AgentCapabilities, ClientConnection, LoadSessionResponse, NewSessionResponse,
    RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionNotification,
} from '@agentclientprotocol/sdk' with { "resolution-mode": "import" };

const requestTimeout = 45_000;
const cancelTimeout = 10_000;
const execFileAsync = promisify(execFile);
const legacyModelConfigId = '_kiro_v2_model';

export type KiroEngine = 'v2' | 'v3';
type SessionState = LoadSessionResponse & {
    models?: {
        currentModelId: string;
        availableModels: { modelId: string; name: string; description?: string | null }[];
    } | null;
};
type ModelSelect = Extract<SessionConfigOption, { type: 'select' }>;

interface CliOptions {
    executable: string;
    engine?: KiroEngine;
    args?: string[];
    cwd: string;
    log(text: string): void;
    update(notification: SessionNotification): void;
    session(sessionId: string, state: LoadSessionResponse): void;
    disconnected(reason: string): void;
    permission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}

export class KiroCli {
    private process?: ChildProcessWithoutNullStreams;
    private connection?: ClientConnection;
    private opening?: Promise<AgentCapabilities>;
    private turn?: AbortController;
    private readonly lifetime = new AbortController();
    private sessionUpdates?: SessionNotification[];
    private configOptions: SessionConfigOption[] = [];
    private legacyModel?: ModelSelect;
    private disposed = false;
    sessionId?: string;

    constructor(private readonly options: CliOptions) {}

    private agent() {
        if (!this.connection) {
            throw new Error('The Kiro CLI connection is closed.');
        }
        return this.connection.agent;
    }

    connect() {
        return this.opening ??= this.start().catch((error: unknown) => {
            this.disconnect(error instanceof Error ? error.message : String(error));
            throw error;
        });
    }

    private async start() {
        const sdk = await import('@agentclientprotocol/sdk');
        const args = await this.launchArgs();
        if (this.disposed) {
            throw new Error('The Kiro CLI connection was closed.');
        }
        const { executable, cwd } = this.options;
        const child = spawn(executable, ['acp', ...args], { cwd, windowsHide: true, shell: false });
        this.process = child;
        child.stderr.setEncoding('utf8').on('data', (text: string) => this.options.log(text));

        const app = sdk.client()
            .onNotification('session/update', ({ params }) => {
                if (this.sessionUpdates) {
                    this.sessionUpdates.push(params);
                } else if (params.sessionId === this.sessionId) {
                    this.deliverUpdate(params);
                }
            })
            .onRequest('session/request_permission', async ({ params, signal }) => {
                const turn = this.turn;
                if (!turn || params.sessionId !== this.sessionId || turn.signal.aborted || this.disposed) {
                    return { outcome: { outcome: 'cancelled' } };
                }
                return this.options.permission(params, AbortSignal.any([signal, turn.signal]));
            });

        const stream = sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
        const connection = app.connect(stream);
        this.connection = connection;
        child.on('error', error => {
            this.disconnect(`Could not run ${executable}: ${error.message}. Check Kiro CLI installation and rpaKiro.cliPath.`);
        });
        child.once('close', (code, signal) => {
            this.disconnect(`Kiro CLI exited (${signal ?? code}). See the Kiro CLI output channel.`);
        });
        void connection.closed.then(() => this.disconnect('Kiro CLI closed the ACP connection. See the Kiro CLI output channel.'));

        const response = await this.withTimeout(this.agent().request('initialize', {
            protocolVersion: sdk.PROTOCOL_VERSION,
            clientInfo: { name: 'rpa-kiro-vsx', title: 'Kiro CLI ACP for VS Code', version: '0.5.0' },
            clientCapabilities: {},
        }), 'ACP initialization');
        if (response.protocolVersion !== sdk.PROTOCOL_VERSION) {
            throw new Error(`Unsupported ACP version: ${response.protocolVersion}.`);
        }
        return response.agentCapabilities ?? {};
    }

    private async launchArgs(): Promise<string[]> {
        const { executable, engine, args, cwd } = this.options;
        if (!engine) {
            // Keep explicit argument arrays from existing installations working as before.
            return args ?? ['--agent-engine=v3'];
        }
        const extra = (args ?? []).filter((arg, index, all) =>
            arg !== '--agent-engine' && !arg.startsWith('--agent-engine=') && all[index - 1] !== '--agent-engine',
        );
        if (engine === 'v2') {
            // Older CLI 2.x builds with ACP only expose the V2 harness and lack this flag.
            const help = await execFileAsync(executable, ['acp', '--help'], {
                cwd, windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024, signal: this.lifetime.signal,
            }).catch((error: Error) => {
                throw new Error(`Could not check Kiro CLI ACP support. Check rpaKiro.cliPath and run kiro-cli acp --help. ${error.message}`);
            });
            if (!/(^|\s)--agent-engine(?:\s|=|$)/m.test(`${help.stdout}\n${help.stderr}`)) {
                return extra;
            }
        }
        return [`--agent-engine=${engine}`, ...extra];
    }

    async list(cursor?: string) {
        return this.withTimeout(this.agent().request('session/list', { cwd: this.options.cwd, cursor }), 'Listing sessions');
    }

    async openSession(requestedId?: string, additionalDirectories?: string[]) {
        const request = { cwd: this.options.cwd, mcpServers: [], additionalDirectories };
        const buffered: SessionNotification[] = [];
        this.sessionUpdates = buffered;
        try {
            let sessionId: string;
            let state: SessionState;
            if (requestedId) {
                state = await this.withTimeout(this.agent().request('session/load', {
                    ...request, sessionId: requestedId,
                }), 'Loading the session') ?? {};
                sessionId = requestedId;
            } else {
                const created: NewSessionResponse & SessionState = await this.withTimeout(
                    this.agent().request('session/new', request), 'Creating the session',
                );
                sessionId = created.sessionId;
                state = created;
            }
            if (!sessionId) {
                throw new Error('Kiro CLI returned no session ID.');
            }
            this.sessionId = sessionId;
            this.configOptions = state.configOptions ?? [];
            this.legacyModel = toLegacyModelConfig(state.models);
            this.options.session(sessionId, { ...state, configOptions: this.visibleConfigs() });
        } finally {
            this.sessionUpdates = undefined;
            for (const notification of buffered) {
                if (notification.sessionId === this.sessionId) {
                    this.deliverUpdate(notification);
                }
            }
        }
    }

    async prompt(text: string) {
        const sessionId = this.requireSession();
        if (this.turn) {
            throw new Error('A Kiro turn is already running.');
        }
        const turn = new AbortController();
        this.turn = turn;
        try {
            return await this.agent().request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
        } finally {
            this.turn = undefined;
            turn.abort();
        }
    }

    async cancel() {
        const turn = this.turn;
        if (!turn || turn.signal.aborted) {
            return;
        }
        const sent = this.agent().notify('session/cancel', { sessionId: this.requireSession() });
        turn.abort();
        const timer = setTimeout(() => {
            if (this.turn === turn) {
                this.disconnect('Kiro CLI did not finish cancelling. The connection was closed.');
            }
        }, cancelTimeout);
        timer.unref();
        await sent;
    }

    async setConfig(configId: string, value: string | boolean) {
        const sessionId = this.requireSession();
        const legacyModel = this.legacyModel;
        if (legacyModel && configId === legacyModel.id) {
            if (typeof value !== 'string' || !legacyModel.options.some(option => 'value' in option && option.value === value)) {
                throw new Error('Kiro CLI did not advertise that model for this session.');
            }
            await this.withTimeout(this.agent().request('session/set_model', {
                sessionId, modelId: value,
            }), 'Changing the V2 model');
            this.legacyModel = { ...legacyModel, currentValue: value };
            return { configOptions: this.visibleConfigs() };
        }
        const selection = typeof value === 'string' ? { value } : { type: 'boolean' as const, value };
        const response = await this.withTimeout(this.agent().request('session/set_config_option', {
            sessionId, configId, ...selection,
        }), 'Changing session configuration');
        this.configOptions = response.configOptions;
        return { ...response, configOptions: this.visibleConfigs() };
    }

    private visibleConfigs() {
        if (!this.legacyModel || this.configOptions.some(option => option.category === 'model' || option.id === 'model')) {
            return this.configOptions;
        }
        return [this.legacyModel, ...this.configOptions];
    }

    private deliverUpdate(notification: SessionNotification) {
        const { update } = notification;
        if (update.sessionUpdate === 'config_option_update') {
            this.configOptions = update.configOptions;
            this.options.update({ ...notification, update: { ...update, configOptions: this.visibleConfigs() } });
        } else {
            this.options.update(notification);
        }
    }

    setMode(modeId: string) {
        return this.withTimeout(this.agent().request('session/set_mode', {
            sessionId: this.requireSession(), modeId,
        }), 'Changing agent mode');
    }

    private requireSession() {
        if (!this.sessionId) {
            throw new Error('No Kiro session is open.');
        }
        return this.sessionId;
    }

    private async withTimeout<T>(request: Promise<T>, action: string): Promise<T> {
        const timer = setTimeout(() => this.disconnect(`${action} timed out. See the Kiro CLI output channel.`), requestTimeout);
        try {
            return await request;
        } finally {
            clearTimeout(timer);
        }
    }

    private disconnect(reason: string) {
        if (!this.disposed) {
            this.dispose(new Error(reason));
            this.options.disconnected(reason);
        }
    }

    dispose(reason?: Error) {
        this.disposed = true;
        this.lifetime.abort();
        this.turn?.abort();
        this.connection?.close(reason);
        this.connection = undefined;
        this.process?.kill();
        this.process = undefined;
        this.sessionId = undefined;
    }
}

function toLegacyModelConfig(models: SessionState['models']): ModelSelect | undefined {
    if (!models?.availableModels?.length) {
        return undefined;
    }
    return {
        id: legacyModelConfigId,
        type: 'select',
        name: 'Model',
        category: 'model',
        currentValue: models.currentModelId,
        options: models.availableModels.map(model => ({
            value: model.modelId, name: model.name, description: model.description,
        })),
    };
}
