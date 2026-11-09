import * as vscode from 'vscode';
import { buildSpecPrompt, parseSpecTasks, remainingRequiredTasks, type SpecTask } from './spec-tasks';

const viewId = 'rpaKiro.specs';
const documentNames = ['requirements.md', 'bugfix.md', 'design.md', 'tasks.md'];

interface Spec {
    folder: vscode.WorkspaceFolder;
    name: string;
    uri: vscode.Uri;
    files: string[];
    tasks?: SpecTask[];
}

type SpecNode = { kind: 'spec'; spec: Spec };
type TaskNode = { kind: 'task'; spec: Spec; task: SpecTask };
type Node = SpecNode | TaskNode
    | { kind: 'workspace'; folder: vscode.WorkspaceFolder; specs: Spec[] }
    | { kind: 'file'; uri: vscode.Uri; name: string };

export function registerSpecExplorer(prepareChat: (folder: vscode.WorkspaceFolder, prompt: string) => Promise<void>) {
    const provider = new SpecExplorer();
    const watcher = vscode.workspace.createFileSystemWatcher('**/.kiro/specs/**');
    return vscode.Disposable.from(
        provider,
        vscode.window.registerTreeDataProvider(viewId, provider),
        watcher,
        watcher.onDidCreate(() => provider.scheduleRefresh()),
        watcher.onDidChange(() => provider.scheduleRefresh()),
        watcher.onDidDelete(() => provider.scheduleRefresh()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => provider.scheduleRefresh()),
        vscode.commands.registerCommand('rpaKiro.refreshSpecs', () => provider.refresh()),
        vscode.commands.registerCommand('rpaKiro.runSpecTask', async (node?: TaskNode) => {
            if (node?.kind !== 'task') {
                return;
            }
            const current = await reloadSpec(node.spec);
            const matches = current?.tasks?.filter(task => task.title === node.task.title);
            const task = matches?.find(candidate => candidate.line === node.task.line)
                ?? (matches?.length === 1 ? matches[0] : undefined);
            if (!current || !task || task.state === 'done') {
                provider.refresh();
                void vscode.window.showInformationMessage('The selected task changed or is already complete. Choose a current task from Kiro Specs.');
                return;
            }
            await prepareChat(current.folder, buildSpecPrompt(relativeSpecPath(current), current.files, [task]));
        }),
        vscode.commands.registerCommand('rpaKiro.prepareSpec', async (node?: SpecNode) => {
            if (node?.kind !== 'spec') {
                return;
            }
            const current = await reloadSpec(node.spec);
            if (!current) {
                provider.refresh();
                void vscode.window.showInformationMessage('The spec is no longer available. Refresh Kiro Specs and select a current spec.');
                return;
            }
            const pending = remainingRequiredTasks(current.tasks ?? []);
            const review = { label: 'Review spec', description: 'Check the spec for gaps', tasks: undefined };
            const choices = pending.length ? [
                { label: 'Run next task', description: pending[0].title, tasks: pending.slice(0, 1) },
                { label: 'Run remaining tasks', description: `${pending.length} required task(s)`, tasks: pending },
                review,
            ] : [review];
            const selected = await vscode.window.showQuickPick(choices, { title: `Prepare a Kiro prompt · ${current.name}` });
            if (selected) {
                await prepareChat(current.folder, buildSpecPrompt(relativeSpecPath(current), current.files, selected.tasks));
            }
        }),
    );
}

class SpecExplorer implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private refreshTimer?: NodeJS.Timeout;

    scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), 200);
    }

    refresh() {
        clearTimeout(this.refreshTimer);
        this.changed.fire();
    }

    dispose() {
        clearTimeout(this.refreshTimer);
        this.changed.dispose();
    }

    async getChildren(node?: Node): Promise<Node[]> {
        if (!node) {
            const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
            const groups = await Promise.all(folders.map(async folder => ({
                kind: 'workspace' as const, folder, specs: await readSpecs(folder),
            })));
            return groups.filter(group => group.specs.length);
        }
        if (node.kind === 'workspace') {
            return node.specs.map(spec => ({ kind: 'spec', spec }));
        }
        if (node.kind === 'spec') {
            const { spec } = node;
            return [
                ...spec.files.map(name => ({ kind: 'file' as const, name, uri: vscode.Uri.joinPath(spec.uri, name) })),
                ...(spec.tasks ?? []).map(task => ({ kind: 'task' as const, task, spec })),
            ];
        }
        return [];
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'workspace') {
            const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
            item.id = node.folder.uri.toString();
            item.iconPath = new vscode.ThemeIcon('root-folder');
            return item;
        }
        if (node.kind === 'spec') {
            const { spec } = node;
            const item = new vscode.TreeItem(spec.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.id = spec.uri.toString();
            item.contextValue = 'kiroSpec';
            item.iconPath = new vscode.ThemeIcon('checklist');
            const count = spec.tasks?.length;
            if (count) {
                const done = spec.tasks?.filter(task => task.state === 'done').length;
                item.description = `${done}/${count} complete`;
            } else {
                item.description = count === 0 ? 'No tasks'
                    : spec.files.includes('tasks.md') ? 'Tasks unavailable' : 'Draft';
            }
            return item;
        }
        if (node.kind === 'file') {
            const item = new vscode.TreeItem(node.name);
            item.id = node.uri.toString();
            item.resourceUri = node.uri;
            item.command = { command: 'vscode.open', title: 'Open spec file', arguments: [node.uri] };
            return item;
        }
        const { task, spec } = node;
        const item = new vscode.TreeItem(task.title);
        const uri = vscode.Uri.joinPath(spec.uri, 'tasks.md');
        item.id = `${uri.toString()}#task-${task.line}`;
        item.contextValue = task.state === 'done' ? 'kiroSpecTaskDone' : 'kiroSpecTask';
        item.description = task.optional ? `${task.state} · optional` : task.state;
        const icons = { done: 'check', pending: 'circle-outline', queued: 'clock', 'in progress': 'sync' };
        item.iconPath = new vscode.ThemeIcon(icons[task.state]);
        item.command = {
            command: 'vscode.open', title: 'Open task',
            arguments: [uri, { selection: new vscode.Range(task.line, 0, task.line, 0) }],
        };
        return item;
    }
}

async function readSpecs(folder: vscode.WorkspaceFolder) {
    const root = vscode.Uri.joinPath(folder.uri, '.kiro', 'specs');
    const entries = await readDirectory(root);
    const names = entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name);
    const specs = await Promise.all(names.sort((a, b) => a.localeCompare(b)).map(name => readSpec(folder, name)));
    return specs.filter(spec => spec !== undefined);
}

async function reloadSpec(spec: Spec) {
    const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === spec.folder.uri.toString());
    return folder && readSpec(folder, spec.name);
}

async function readSpec(folder: vscode.WorkspaceFolder, name: string): Promise<Spec | undefined> {
    const uri = vscode.Uri.joinPath(folder.uri, '.kiro', 'specs', name);
    const entries = await readDirectory(uri);
    const files = documentNames.filter(file => entries.some(([entry, type]) => entry === file && type === vscode.FileType.File));
    if (!files.length) {
        return undefined;
    }
    let tasks: SpecTask[] | undefined;
    if (files.includes('tasks.md')) {
        try {
            const markdown = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uri, 'tasks.md'));
            tasks = parseSpecTasks(new TextDecoder().decode(markdown));
        } catch {
            // Keep the spec visible if its task list cannot be read.
        }
    }
    return { folder, name, uri, files, tasks };
}

async function readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
        return await vscode.workspace.fs.readDirectory(uri);
    } catch {
        return [];
    }
}

function relativeSpecPath(spec: Spec) {
    return `.kiro/specs/${spec.name}`;
}
