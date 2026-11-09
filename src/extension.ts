import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { ChatPanel } from './chat';
import { checkKiroConnection } from './kiro-network';
import { registerSpecExplorer } from './spec-explorer';
import { registerQualityDiagnostics } from './quality-diagnostics';
import { registerSteeringView } from './steering-view';

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Kiro CLI');
    const chats = new Map<string, ChatPanel>();

    async function openChat(folder: vscode.WorkspaceFolder) {
        const key = folder.uri.toString();
        const existing = chats.get(key);
        if (existing) {
            existing.reveal();
            return existing;
        }
        const media = vscode.Uri.joinPath(context.extensionUri, 'media');
        const template = await readFile(vscode.Uri.joinPath(media, 'chat.html').fsPath, 'utf8');
        const openedWhileReading = chats.get(key);
        if (openedWhileReading) {
            openedWhileReading.reveal();
            return openedWhileReading;
        }
        const chat = new ChatPanel(folder, media, template, output, () => chats.delete(key));
        chats.set(key, chat);
        return chat;
    }

    context.subscriptions.push(
        output,
        registerSteeringView(),
        registerQualityDiagnostics(),
        registerSpecExplorer(async (folder, prompt) => {
            if (!vscode.workspace.isTrusted) {
                void vscode.window.showWarningMessage('Trust this workspace in VS Code to use Kiro CLI.');
                return;
            }
            const chat = await openChat(folder);
            chat.preparePrompt(prompt);
        }),
        vscode.commands.registerCommand('rpaKiro.showOutput', () => output.show()),
        vscode.commands.registerCommand('rpaKiro.checkDirectConnection', async () => {
            const proxyUrl = vscode.workspace.getConfiguration('rpaKiro').get<string>('directProxyUrl', '');
            try {
                const { usedProxy, status } = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Checking the direct Kiro connection…' },
                    () => checkKiroConnection(proxyUrl),
                );
                const route = usedProxy ? 'the configured proxy' : 'VS Code networking';
                void vscode.window.showInformationMessage(`Reached the public Kiro endpoint via ${route} (HTTP ${status}).`);
            } catch (error) {
                void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not check the direct Kiro connection.');
            }
        }),
        vscode.commands.registerCommand('rpaKiro.openChat', async () => {
            if (!vscode.workspace.isTrusted) {
                void vscode.window.showWarningMessage('Trust this workspace in VS Code to use Kiro CLI.');
                return;
            }
            const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
            if (!folders.length) {
                void vscode.window.showInformationMessage('Open a project folder before starting Kiro CLI.');
                return;
            }
            const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
                folders.map(item => ({ label: item.name, description: item.uri.fsPath, folder: item })),
                { title: 'Choose the workspace folder for Kiro CLI' },
            ))?.folder;
            if (folder) {
                await openChat(folder);
            }
        }),
        { dispose: () => { for (const chat of chats.values()) { chat.dispose(); } } },
    );
}
