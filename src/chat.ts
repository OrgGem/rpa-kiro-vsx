import * as vscode from 'vscode';
import type {
    AgentCapabilities, RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption,
    SessionModeState, SessionNotification,
} from '@agentclientprotocol/sdk' with { "resolution-mode": "import" };
import { KiroCli, type KiroEngine } from './cli';

export class ChatPanel implements vscode.Disposable {
    private readonly panel: vscode.WebviewPanel;
    private readonly lifetime = new vscode.CancellationTokenSource();
    private readonly lifetimeToken = this.lifetime.token;
    private cli?: KiroCli;
    private busy = false;
    private prompting = false;
    private configs: SessionConfigOption[] = [];
    private modes?: SessionModeState;
    private webviewReady = false;
    private draft?: { text: string; sending: boolean };

    constructor(
        private readonly folder: vscode.WorkspaceFolder,
        media: vscode.Uri,
        template: string,
        private readonly output: vscode.OutputChannel,
        onClose: () => void,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'rpaKiro.chat', `Kiro CLI · ${folder.name}`, vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
        );
        const webview = this.panel.webview;
        const subscription = webview.onDidReceiveMessage(message => {
            if (message && typeof message === 'object') {
                void this.handle(message);
            }
        });
        const visibility = this.panel.onDidChangeViewState(() => void this.flushDraft());
        this.panel.onDidDispose(() => {
            this.lifetime.cancel();
            this.lifetime.dispose();
            subscription.dispose();
            visibility.dispose();
            this.cli?.dispose();
            onClose();
        });
        webview.html = template
            .replaceAll('{{csp}}', webview.cspSource)
            .replace('{{style}}', webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css')).toString())
            .replace('{{script}}', webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js')).toString());
    }

    reveal() {
        this.panel.reveal();
    }

    dispose() {
        this.panel.dispose();
    }

    preparePrompt(text: string) {
        this.draft = { text, sending: false };
        void this.flushDraft();
    }

    private async flushDraft() {
        const draft = this.draft;
        if (!draft || draft.sending || !this.webviewReady || !this.panel.visible || this.lifetimeToken.isCancellationRequested) {
            return;
        }
        draft.sending = true;
        try {
            const delivered = await this.panel.webview.postMessage({ type: 'draft', text: draft.text });
            if (delivered && this.draft === draft) {
                this.draft = undefined;
            }
        } finally {
            draft.sending = false;
        }
    }

    private post(type: string, fields: Record<string, unknown> = {}) {
        if (!this.lifetimeToken.isCancellationRequested) {
            void this.panel.webview.postMessage({ type, ...fields });
        }
    }

    private async handle(message: { type?: unknown; text?: unknown }) {
        if (message.type === 'ready') {
            this.webviewReady = true;
            this.post('ready', { folder: this.folder.name });
            await this.flushDraft();
            return;
        }
        if (message.type === 'output') {
            this.output.show();
            return;
        }
        if (message.type === 'cancel' && this.prompting) {
            try {
                await this.cli?.cancel();
            } catch (error) {
                this.post('error', { text: errorText(error) });
            }
            return;
        }
        if (this.busy || !vscode.workspace.isTrusted) {
            return;
        }
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        switch (message.type) {
            case 'prompt':
                if (text) {
                    await this.run(async cli => {
                        if (!cli.sessionId) {
                            await cli.openSession();
                        }
                        this.prompting = true;
                        this.post('promptStarted', { text });
                        const response = await cli.prompt(text);
                        this.post('status', { text: stopReason(response.stopReason) });
                    });
                }
                break;
            case 'new':
                await this.run(cli => cli.openSession());
                break;
            case 'load':
                await this.run((cli, capabilities) => this.load(cli, capabilities));
                break;
            case 'configure':
                await this.run(cli => this.configure(cli));
                break;
        }
    }

    private async run(action: (cli: KiroCli, capabilities: AgentCapabilities) => Promise<void>) {
        this.busy = true;
        this.post('busy');
        try {
            const cli = this.cli ??= this.createCli();
            const capabilities = await cli.connect();
            this.post('capabilities', { load: capabilities.loadSession === true });
            await action(cli, capabilities);
        } catch (error) {
            this.post('error', { text: errorText(error) });
        } finally {
            this.busy = false;
            this.prompting = false;
            this.post('idle');
        }
    }

    private createCli() {
        const settings = vscode.workspace.getConfiguration('rpaKiro');
        const cli = new KiroCli({
            executable: settings.get<string>('cliPath', 'kiro-cli').trim() || 'kiro-cli',
            engine: settings.inspect<KiroEngine>('engine')?.globalValue,
            args: settings.inspect<string[]>('acpArgs')?.globalValue,
            cwd: this.folder.uri.fsPath,
            log: text => this.output.append(text),
            update: ({ update }) => this.update(update),
            session: (sessionId, state) => {
                this.configs = state.configOptions ?? [];
                this.modes = state.modes ?? undefined;
                this.post('session', { sessionId });
                this.showConfigState();
            },
            disconnected: reason => {
                this.cli = undefined;
                this.configs = [];
                this.modes = undefined;
                this.output.appendLine(reason);
                this.post('disconnected');
                this.showConfigState();
                if (!this.busy) {
                    this.post('error', { text: reason });
                }
            },
            permission: (request, signal) => this.permission(request, signal),
        });
        return cli;
    }

    private async load(cli: KiroCli, capabilities: AgentCapabilities) {
        if (!capabilities.loadSession) {
            this.post('status', { text: 'This Kiro CLI does not advertise session loading.' });
            return;
        }
        let cursor: string | undefined;
        if (capabilities.sessionCapabilities?.list) {
            do {
                const page = await cli.list(cursor);
                const items = page.sessions.map(session => ({
                    label: session.title || session.sessionId,
                    description: session.updatedAt ?? undefined,
                    detail: session.sessionId,
                    sessionId: session.sessionId,
                    additionalDirectories: session.additionalDirectories,
                }));
                items.push({ label: 'Enter a session ID…', description: undefined, detail: '', sessionId: '', additionalDirectories: undefined });
                if (page.nextCursor) {
                    items.push({ label: 'Next page…', description: undefined, detail: '', sessionId: '', additionalDirectories: undefined });
                }
                const selected = await vscode.window.showQuickPick(items, { title: 'Open a Kiro session' }, this.lifetimeToken);
                if (!selected) {
                    return;
                }
                if (selected.sessionId) {
                    await cli.openSession(selected.sessionId, selected.additionalDirectories);
                    return;
                }
                cursor = selected === items.at(-1) && page.nextCursor ? page.nextCursor : undefined;
            } while (cursor);
        }
        const id = await vscode.window.showInputBox({ title: 'Open a Kiro session', prompt: 'Enter the session ID' }, this.lifetimeToken);
        if (id?.trim()) {
            await cli.openSession(id.trim());
        }
    }

    private async configure(cli: KiroCli) {
        const items = this.configs.map(option => ({
            label: option.name, detail: option.description ?? undefined, option,
        }));
        const mode = this.modes;
        const showMode = mode?.availableModes.length && !this.configs.some(option => option.category === 'mode' || option.id === 'mode');
        const selected = await vscode.window.showQuickPick(
            [...items, ...(showMode ? [{ label: 'Mode', detail: undefined, option: undefined }] : [])],
            { title: 'Configure the Kiro session' }, this.lifetimeToken,
        );
        if (!selected) {
            return;
        }
        const option = selected.option;
        if (!option && mode) {
            const value = await vscode.window.showQuickPick(mode.availableModes.map(item => ({
                label: item.name, description: item.id === mode.currentModeId ? 'Current' : undefined,
                detail: item.description ?? undefined, id: item.id,
            })), { title: 'Choose agent mode' }, this.lifetimeToken);
            if (value) {
                await cli.setMode(value.id);
                if (this.modes) {
                    this.modes = { ...this.modes, currentModeId: value.id };
                }
            }
        }
        if (option) {
            const choices = option.type === 'select'
                ? option.options.flatMap(entry => 'options' in entry ? entry.options : [entry])
                : [{ name: 'On', value: true, description: null }, { name: 'Off', value: false, description: null }];
            const value = await vscode.window.showQuickPick(choices.map(item => ({
                label: item.name, description: item.value === option.currentValue ? 'Current' : undefined,
                detail: item.description ?? undefined, value: item.value,
            })), { title: `Choose ${option.name}` }, this.lifetimeToken);
            if (value) {
                const result = await cli.setConfig(option.id, value.value);
                this.configs = result.configOptions;
            }
        }
        this.showConfigState();
    }

    private showConfigState() {
        const selections = this.configs.map(option => {
            const current = option.type === 'select'
                ? option.options.flatMap(entry => 'options' in entry ? entry.options : [entry])
                    .find(value => value.value === option.currentValue)?.name ?? option.currentValue
                : option.currentValue ? 'On' : 'Off';
            return `${option.name}: ${current}`;
        });
        if (this.modes && !this.configs.some(option => option.category === 'mode' || option.id === 'mode')) {
            const mode = this.modes.availableModes.find(value => value.id === this.modes?.currentModeId);
            selections.unshift(`Mode: ${mode?.name ?? this.modes.currentModeId}`);
        }
        this.post('config', { selections });
    }

    private update(update: SessionNotification['update']) {
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
            case 'user_message_chunk':
                if (update.content.type === 'text' && (update.sessionUpdate === 'agent_message_chunk' || !this.prompting)) {
                    this.post('chunk', {
                        role: update.sessionUpdate === 'agent_message_chunk' ? 'kiro' : 'user',
                        text: update.content.text, messageId: update.messageId,
                    });
                }
                break;
            case 'tool_call':
            case 'tool_call_update':
                this.post('tool', { id: update.toolCallId, title: update.title, status: update.status });
                break;
            case 'current_mode_update':
                if (this.modes) {
                    this.modes = { ...this.modes, currentModeId: update.currentModeId };
                    this.showConfigState();
                }
                break;
            case 'config_option_update':
                this.configs = update.configOptions;
                this.showConfigState();
                break;
        }
    }

    private async permission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
        const cancelled = { outcome: { outcome: 'cancelled' as const } };
        const options = request.options.filter(option => option.kind === 'allow_once' || option.kind === 'reject_once');
        if (signal.aborted || !vscode.workspace.isTrusted || !options.length) {
            return cancelled;
        }
        const consent = (request._meta?.kiro as { consent?: { triggeringResource?: unknown; resource?: unknown } } | undefined)?.consent;
        const resource = consent?.triggeringResource ?? consent?.resource;
        const rawInput = request.toolCall.rawInput;
        const detail = typeof resource === 'string' ? resource
            : typeof rawInput === 'string' ? rawInput
            : rawInput == null ? undefined : JSON.stringify(rawInput);
        const token = new vscode.CancellationTokenSource();
        const cancel = () => token.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        try {
            const choice = await vscode.window.showQuickPick(options.map(option => ({
                label: option.name,
                description: option.kind === 'allow_once' ? 'Allow once' : 'Deny once',
                detail,
                optionId: option.optionId,
            })), {
                title: `Kiro requests permission · ${this.folder.name}`,
                placeHolder: request.toolCall.title ?? 'Review the requested tool action',
                ignoreFocusOut: true,
            }, token.token);
            return choice && !token.token.isCancellationRequested
                ? { outcome: { outcome: 'selected', optionId: choice.optionId } }
                : cancelled;
        } finally {
            signal.removeEventListener('abort', cancel);
            token.dispose();
        }
    }
}

function errorText(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown } | undefined)?.code;
    return code === -32000
        ? `${text} Run kiro-cli login in a terminal on the extension host and try again.`
        : text;
}

function stopReason(reason: string) {
    const labels: Record<string, string> = {
        end_turn: 'Ready', cancelled: 'Turn cancelled', max_tokens: 'Output token limit reached',
        max_turn_requests: 'Turn request limit reached', refusal: 'Kiro declined this request',
    };
    return labels[reason] ?? `Turn ended: ${reason}`;
}
