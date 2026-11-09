import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { checkQuality, checkSteering, parseQualityRules, qualityConfigName, type QualityProblem } from './quality-rules';

const configPath = `.kiro/${qualityConfigName}`;
const source = 'Kiro Quality';
const severity = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
};

export function registerQualityDiagnostics() {
    const collection = vscode.languages.createDiagnosticCollection('kiro-quality');
    const cache = new Map<string, Promise<ReturnType<typeof parseQualityRules>>>();
    let disposed = false;

    function refresh() {
        cache.clear();
        collection.clear();
        for (const document of vscode.workspace.textDocuments) {
            void validate(document);
        }
    }

    async function validate(document: vscode.TextDocument) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (disposed || !folder || document.uri.scheme !== 'file' || !vscode.workspace.isTrusted) {
            return;
        }
        const path = relative(folder.uri.fsPath, document.uri.fsPath).split(sep).join('/');
        const version = document.version;
        const text = document.getText();
        if (path === configPath) {
            collection.set(document.uri, parseQualityRules(text).problems.map(issue => diagnostic(issue, document)));
            return;
        }
        const key = folder.uri.toString();
        const configUri = vscode.Uri.joinPath(folder.uri, configPath);
        let loading = cache.get(key);
        if (!loading) {
            loading = readRules(configUri);
            cache.set(key, loading);
        }
        const { rules, problems } = await loading;
        if (disposed || document.isClosed || document.version !== version || cache.get(key) !== loading) {
            return;
        }
        if (!vscode.workspace.textDocuments.some(item => item.uri.toString() === configUri.toString() && !item.isClosed)) {
            collection.set(configUri, problems.map(issue => diagnostic(issue)));
        }
        const steering = path.startsWith('.kiro/steering/') && /\.md$/i.test(path);
        const issues = [...(steering ? checkSteering(text) : []), ...checkQuality(path, text, rules)];
        collection.set(document.uri, issues.map(issue => diagnostic(issue, document)));
    }

    const watcher = vscode.workspace.createFileSystemWatcher(`**/${configPath}`);
    refresh();
    return vscode.Disposable.from(
        { dispose: () => { disposed = true; cache.clear(); } },
        collection, watcher,
        watcher.onDidChange(refresh),
        watcher.onDidCreate(refresh),
        watcher.onDidDelete(refresh),
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
        vscode.workspace.onDidOpenTextDocument(document => void validate(document)),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.uri.path.endsWith(`/${configPath}`)) {
                refresh();
            } else {
                void validate(document);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => collection.delete(document.uri)),
        vscode.commands.registerCommand('rpaKiro.validateFile', async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!document || document.uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(document.uri)) {
                void vscode.window.showInformationMessage('Open a workspace file to run Kiro Quality checks.');
                return;
            }
            await validate(document);
            await vscode.commands.executeCommand('workbench.action.problems.focus');
        }),
    );
}

async function readRules(uri: vscode.Uri): Promise<ReturnType<typeof parseQualityRules>> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 256 * 1024) {
            throw new Error('The quality configuration exceeds 256 KiB.');
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        return parseQualityRules(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            return { rules: [], problems: [] };
        }
        return { rules: [], problems: [{
            code: 'quality-config', severity: 'error', offset: 0, length: 1,
            message: 'Could not read the quality configuration as a UTF-8 file up to 256 KiB.',
        }] };
    }
}

function diagnostic(issue: QualityProblem, document?: vscode.TextDocument) {
    const range = document
        ? new vscode.Range(document.positionAt(issue.offset), document.positionAt(issue.offset + issue.length))
        : new vscode.Range(0, 0, 0, 1);
    const item = new vscode.Diagnostic(range, issue.message, severity[issue.severity]);
    item.source = source;
    item.code = issue.code;
    return item;
}
