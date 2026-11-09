import { randomUUID } from 'node:crypto';
import { basename, relative } from 'node:path';
import * as vscode from 'vscode';
import { qualityConfigName } from './quality-rules';
import { applyPack, previewPack, type PackChange } from './steering-pack';

const viewId = 'rpaKiro.steering';
const scheme = 'rpa-kiro-pack-diff';

interface Pack {
    id: string;
    name: string;
    folder: vscode.WorkspaceFolder;
    changes: PackChange[];
    reviewed: Set<PackChange>;
    applying: boolean;
}

type PackNode = { kind: 'pack'; pack: Pack };
type ChangeNode = { kind: 'change'; pack: Pack; change: PackChange };
type Node = PackNode | ChangeNode | { kind: 'folder'; folder: vscode.WorkspaceFolder }
    | { kind: 'file'; folder: vscode.WorkspaceFolder; uri: vscode.Uri };

export function registerSteeringView() {
    const view = new SteeringView();
    const watcher = vscode.workspace.createFileSystemWatcher('**/.kiro/{steering/**,rpa-quality.json}');
    return vscode.Disposable.from(
        view, watcher,
        vscode.window.registerTreeDataProvider(viewId, view),
        vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: uri => view.content(uri) }),
        watcher.onDidCreate(() => view.refresh()),
        watcher.onDidDelete(() => view.refresh()),
        vscode.workspace.onDidChangeWorkspaceFolders(({ removed }) => {
            for (const folder of removed) {
                view.discardFolder(folder);
            }
            view.refresh();
        }),
        vscode.commands.registerCommand('rpaKiro.previewSteeringPack', () => view.preview()),
        vscode.commands.registerCommand('rpaKiro.showSteeringDiff', (node?: ChangeNode) => {
            if (node?.kind === 'change') {
                return view.openDiff(node.pack, node.change);
            }
        }),
        vscode.commands.registerCommand('rpaKiro.applySteeringPack', (node?: PackNode) => {
            if (node?.kind === 'pack') {
                return view.apply(node.pack);
            }
        }),
        vscode.commands.registerCommand('rpaKiro.discardSteeringPack', (node?: PackNode) => {
            if (node?.kind === 'pack' && !node.pack.applying && view.isPending(node.pack)) {
                view.discardFolder(node.pack.folder);
                view.refresh();
            }
        }),
    );
}

class SteeringView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly pending = new Map<string, Pack>();
    readonly onDidChangeTreeData = this.changed.event;

    refresh() {
        this.changed.fire();
    }

    dispose() {
        this.pending.clear();
        this.changed.dispose();
    }

    discardFolder(folder: vscode.WorkspaceFolder) {
        this.pending.delete(folder.uri.toString());
    }

    isPending(pack: Pack) {
        return this.pending.get(pack.folder.uri.toString()) === pack;
    }

    async preview() {
        if (!vscode.workspace.isTrusted) {
            return;
        }
        const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
        if (!folders.length) {
            void vscode.window.showInformationMessage('Open a workspace folder before previewing a steering pack.');
            return;
        }
        const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
            folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
            { title: 'Choose the workspace folder for the steering pack' },
        ))?.folder;
        if (!folder) {
            return;
        }
        const [source] = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: 'Preview Steering Pack', title: 'Choose a local steering pack folder',
        }) ?? [];
        if (!source || source.scheme !== 'file') {
            return;
        }
        try {
            const changes = await previewPack(source.fsPath, folder.uri.fsPath);
            if (!changes.length) {
                void vscode.window.showInformationMessage('The steering pack already matches this workspace.');
                return;
            }
            const key = folder.uri.toString();
            if (this.pending.get(key)?.applying || !vscode.workspace.workspaceFolders?.some(item => item.uri.toString() === key)) {
                throw new Error('The workspace is unavailable for a new pack preview.');
            }
            const pack = {
                id: randomUUID(), name: basename(source.fsPath), folder, changes,
                reviewed: new Set<PackChange>(), applying: false,
            };
            this.pending.set(key, pack);
            this.refresh();
            await vscode.commands.executeCommand(`${viewId}.focus`);
            await this.openDiff(pack, changes[0]);
        } catch (error) {
            void vscode.window.showErrorMessage(message(error));
        }
    }

    async openDiff(pack: Pack, change: PackChange) {
        const index = pack.changes.indexOf(change);
        if (!this.isPending(pack) || index < 0) {
            return;
        }
        const before = vscode.Uri.from({ scheme, path: `/${pack.id}/before/${index}/${change.path}` });
        const after = vscode.Uri.from({ scheme, path: `/${pack.id}/after/${index}/${change.path}` });
        await vscode.commands.executeCommand('vscode.diff', before, after, `Steering pack · ${change.path}`);
        pack.reviewed.add(change);
        this.refresh();
    }

    content(uri: vscode.Uri) {
        const [, id, side, index] = uri.path.split('/');
        const pack = Array.from(this.pending.values()).find(item => item.id === id);
        const change = pack?.changes[Number(index)];
        return (side === 'before' ? change?.before : change?.after) ?? '';
    }

    async apply(pack: Pack) {
        if (!this.isPending(pack) || pack.applying || !vscode.workspace.isTrusted) {
            return;
        }
        if (pack.reviewed.size !== pack.changes.length) {
            void vscode.window.showInformationMessage('Open every pending file diff before applying the pack.');
            return;
        }
        pack.applying = true;
        try {
            const confirm = 'Apply Pack';
            const choice = await vscode.window.showWarningMessage(
                `Apply ${pack.changes.length} reviewed change(s) to ${pack.folder.name}?`, { modal: true }, confirm,
            );
            if (choice !== confirm || !this.isPending(pack)) {
                return;
            }
            await applyPack(pack.folder.uri.fsPath, pack.changes, file =>
                vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file'
                    && relative(file, document.uri.fsPath) === ''),
            );
            this.discardFolder(pack.folder);
            this.refresh();
            void vscode.window.showInformationMessage(`Applied ${pack.changes.length} steering pack change(s) to ${pack.folder.name}.`);
        } catch (error) {
            void vscode.window.showErrorMessage(message(error));
        } finally {
            pack.applying = false;
        }
    }

    async getChildren(node?: Node): Promise<Node[]> {
        if (!node) {
            return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
                .map(folder => ({ kind: 'folder', folder }));
        }
        if (node.kind === 'pack') {
            return node.pack.changes.map(change => ({ kind: 'change', pack: node.pack, change }));
        }
        if (node.kind !== 'folder') {
            return [];
        }
        const { folder } = node;
        const [steering, quality] = await Promise.all([
            vscode.workspace.findFiles(new vscode.RelativePattern(folder, '.kiro/steering/**/*.[mM][dD]'), null),
            vscode.workspace.findFiles(new vscode.RelativePattern(folder, `.kiro/${qualityConfigName}`), null),
        ]);
        const files = [...steering.sort((a, b) => a.path.localeCompare(b.path)), ...quality];
        const pack = this.pending.get(folder.uri.toString());
        return [
            ...(pack ? [{ kind: 'pack' as const, pack }] : []),
            ...files.map(uri => ({ kind: 'file' as const, folder, uri })),
        ];
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'folder') {
            const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
            item.id = node.folder.uri.toString();
            item.iconPath = new vscode.ThemeIcon('root-folder');
            return item;
        }
        if (node.kind === 'file') {
            const label = relative(node.folder.uri.fsPath, node.uri.fsPath);
            const item = new vscode.TreeItem(label);
            item.id = node.uri.toString();
            item.resourceUri = node.uri;
            item.command = { command: 'vscode.open', title: 'Open steering or quality file', arguments: [node.uri] };
            return item;
        }
        const { pack } = node;
        if (node.kind === 'pack') {
            const item = new vscode.TreeItem(`Pending pack · ${pack.name}`, vscode.TreeItemCollapsibleState.Expanded);
            item.id = pack.id;
            item.contextValue = 'steeringPack';
            item.description = `${pack.reviewed.size}/${pack.changes.length} diffs opened`;
            item.iconPath = new vscode.ThemeIcon('package');
            return item;
        }
        const { change } = node;
        const item = new vscode.TreeItem(change.path);
        item.id = `${pack.id}/${change.path}`;
        item.description = [change.before === undefined ? 'add' : 'replace', pack.reviewed.has(change) ? 'opened' : 'pending'].join(' · ');
        item.iconPath = new vscode.ThemeIcon('diff');
        item.command = { command: 'rpaKiro.showSteeringDiff', title: 'Preview diff', arguments: [node] };
        return item;
    }
}

function message(error: unknown) {
    return error instanceof Error ? error.message : 'The steering pack operation failed.';
}
